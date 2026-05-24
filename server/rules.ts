import { db, resetDerivedTables } from './db.js';

const actionKeywords = ['报名', '合作', '求推荐', '推荐', '购买', '团购', '招募', '会议', '活动', '价格', '报价', '优惠', '联系', '试用'];
const productKeywords = ['工具', '产品', 'API', '插件', '模型', '软件', '网站', '平台', '开源', 'Agent', '机器人'];
const linkPattern = /(https?:\/\/|www\.|\.com|\.ai|\.dev|\.cn|github\.com)/i;

type MessageRow = {
  id: string;
  group_id: string;
  group_name: string;
  sender: string;
  sent_at: string;
  type: string;
  content: string;
  mentions_me: number;
  has_link: number;
};

export function rebuildSignals() {
  resetDerivedTables();
  const messages = db.prepare(`
    SELECT id, group_id, group_name, sender, sent_at, type, content, mentions_me, has_link
    FROM messages
    ORDER BY sent_at DESC
    LIMIT 50000
  `).all() as MessageRow[];

  const insertSignal = db.prepare(`
    INSERT INTO signals (message_id, kind, score, title, tags)
    VALUES (@message_id, @kind, @score, @title, @tags)
  `);

  const tx = db.transaction(() => {
    for (const message of messages) {
      const signal = scoreMessage(message);
      if (signal.score >= 25) {
        insertSignal.run({
          message_id: message.id,
          kind: signal.kind,
          score: signal.score,
          title: signal.title,
          tags: JSON.stringify(signal.tags)
        });
      }
    }

    db.exec(`
      INSERT INTO sources (sender, score, message_count, group_count, last_seen_at)
      SELECT
        m.sender,
        SUM(CASE WHEN m.has_link = 1 THEN 4 ELSE 1 END + CASE WHEN m.mentions_me = 1 THEN 6 ELSE 0 END) AS score,
        COUNT(*) AS message_count,
        COUNT(DISTINCT m.group_id) AS group_count,
        MAX(m.sent_at) AS last_seen_at
      FROM messages m
      JOIN groups g ON g.id = m.group_id
      WHERE g.chat_type = 'group' AND m.sender <> ''
      GROUP BY m.sender
      HAVING message_count >= 2
      ORDER BY score DESC
      LIMIT 80
    `);
  });

  tx();
}

function scoreMessage(message: MessageRow) {
  const text = message.content || '';
  let score = Math.min(18, Math.floor(text.length / 20));
  const tags: string[] = [];

  if (message.mentions_me) {
    score += 28;
    tags.push('@我');
  }
  if (message.has_link || linkPattern.test(text)) {
    score += 22;
    tags.push('链接信号');
  }

  const actionHits = actionKeywords.filter((word) => text.includes(word));
  if (actionHits.length > 0) {
    score += 18 + actionHits.length * 4;
    tags.push('可跟进');
  }

  const productHits = productKeywords.filter((word) => text.toLowerCase().includes(word.toLowerCase()));
  if (productHits.length > 0) {
    score += 12 + productHits.length * 2;
    tags.push('工具/产品');
  }

  if (/AI|AIGC|LLM|Agent|Claude|GPT|模型|机器人/i.test(text)) {
    score += 10;
    tags.push('AI');
  }

  const kind = actionHits.length > 0 || message.mentions_me ? 'action' : 'signal';
  const title = compactTitle(text);

  return {
    kind,
    score,
    title,
    tags: [...new Set(tags)].slice(0, 4)
  };
}

function compactTitle(text: string) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '未命名消息';
  return oneLine.length > 42 ? `${oneLine.slice(0, 42)}...` : oneLine;
}
