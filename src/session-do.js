// ImageDedupDO — 原子性图片去重检查器
// 每个 userId 对应一个 DO 实例
// 只做一件事：检查 imageKey 是否见过，没见过就标记

export class ImageDedupDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // POST /check — 检查并标记 imageKey
    // body: { imageKey: string }
    // response: { isNew: boolean }
    if (request.method === 'POST' && url.pathname === '/check') {
      const { imageKey } = await request.json();
      if (!imageKey) return Response.json({ isNew: false });

      const seen = await this.state.storage.get(imageKey);
      if (seen) {
        return Response.json({ isNew: false });
      }

      // 标记为已见，TTL 24h（DO storage 不支持 TTL，用时间戳 + 定期清理）
      await this.state.storage.put(imageKey, Date.now());

      // 清理超过 24h 的旧记录（防止无限增长）
      // 只在 storage 条目 > 100 时触发，避免每次都扫
      const all = await this.state.storage.list();
      if (all.size > 100) {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const toDelete = [];
        for (const [key, ts] of all) {
          if (typeof ts === 'number' && ts < cutoff) toDelete.push(key);
        }
        if (toDelete.length > 0) {
          await this.state.storage.delete(toDelete);
        }
      }

      return Response.json({ isNew: true });
    }

    // DELETE /clear — 清空（测试用）
    if (request.method === 'DELETE' && url.pathname === '/clear') {
      await this.state.storage.deleteAll();
      return Response.json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  }
}
