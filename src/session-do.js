// ImageDedupDO
// 职责：图片去重 + 按序存储 items（单线程，无并发写冲突）
// 不做卡片、不做 alarm

export class ImageDedupDO {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // POST /check — 去重 + 注册 chatId/userId
    // body: { imageKey, chatId, userId }
    // response: { isNew: boolean }
    if (request.method === 'POST' && url.pathname === '/check') {
      const { imageKey, chatId, userId } = await request.json();
      if (!imageKey) return Response.json({ isNew: false });

      const seen = await this.state.storage.get(`img:${imageKey}`);
      if (seen) return Response.json({ isNew: false });

      await this.state.storage.put(`img:${imageKey}`, Date.now());

      // 首张图注册上下文
      if (chatId && !(await this.state.storage.get('chatId'))) {
        await this.state.storage.put('chatId', chatId);
        await this.state.storage.put('userId', userId ?? '');
      }

      // 清理 24h 前的旧 img: 记录
      const all = await this.state.storage.list({ prefix: 'img:' });
      if (all.size > 100) {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const toDelete = [];
        for (const [key, ts] of all) {
          if (typeof ts === 'number' && ts < cutoff) toDelete.push(key);
        }
        if (toDelete.length > 0) await this.state.storage.delete(toDelete);
      }

      return Response.json({ isNew: true });
    }

    // POST /result — 按序追加 item，返回当前总数
    // body: { check_id, status, reading, imageKey }
    // response: { count: number }
    if (request.method === 'POST' && url.pathname === '/result') {
      const payload = await request.json();

      const items = (await this.state.storage.get('items')) ?? [];
      items.push({
        type:      'image',
        check_id:  payload.check_id,
        status:    payload.status,
        reading:   payload.reading,
        imageKey:  payload.imageKey,
        timestamp: new Date().toISOString(),
      });
      await this.state.storage.put('items', items);

      return Response.json({ count: items.length });
    }

    // GET /get-items — 读取所有 items（报告生成时调用）
    // response: { items: [...] }
    if (request.method === 'GET' && url.pathname === '/get-items') {
      const items = (await this.state.storage.get('items')) ?? [];
      return Response.json({ items });
    }

    // DELETE /reset — clearSession 时调用
    if (request.method === 'DELETE' && url.pathname === '/reset') {
      await this.state.storage.deleteAll();
      return Response.json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  }
}
