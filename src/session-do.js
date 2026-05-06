// ImageDedupDO
// 职责：去重 + 按序存 items + msgId↔itemId 映射 + item 更新

export class ImageDedupDO {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // POST /check — 去重 + 注册上下文
    if (request.method === 'POST' && url.pathname === '/check') {
      const { imageKey, chatId, userId } = await request.json();
      if (!imageKey) return Response.json({ isNew: false });

      const seen = await this.state.storage.get(`img:${imageKey}`);
      if (seen) return Response.json({ isNew: false });
      await this.state.storage.put(`img:${imageKey}`, Date.now());

      if (chatId && !(await this.state.storage.get('chatId'))) {
        await this.state.storage.put('chatId', chatId);
        await this.state.storage.put('userId', userId ?? '');
      }

      // 清理旧记录
      const all = await this.state.storage.list({ prefix: 'img:' });
      if (all.size > 100) {
        const cutoff = Date.now() - 86400000;
        const toDelete = [];
        for (const [key, ts] of all) {
          if (typeof ts === 'number' && ts < cutoff) toDelete.push(key);
        }
        if (toDelete.length > 0) await this.state.storage.delete(toDelete);
      }
      return Response.json({ isNew: true });
    }

    // POST /result — 追加 item，存 msgId→itemId 映射
    // body: { check_id, reading, imageKey, msgId }
    // response: { count, itemId }
    if (request.method === 'POST' && url.pathname === '/result') {
      const payload = await request.json();
      const items  = (await this.state.storage.get('items')) ?? [];
      const itemId = `item_${Date.now()}_${items.length}`;

      items.push({
        itemId,
        type:      'image',
        check_id:  payload.check_id,
        reading:   payload.reading,
        status:    'pending',
        note:      null,
        imageKey:  payload.imageKey,
        msgId:     payload.msgId ?? null,
        cardMsgId: payload.msgId ?? null,   // 向后兼容（card actions 还用这个查）
        timestamp: new Date().toISOString(),
      });
      await this.state.storage.put('items', items);

      if (payload.msgId) {
        await this.state.storage.put(`msg:${payload.msgId}`, itemId);
      }

      return Response.json({ count: items.length, itemId });
    }

    // PATCH /item — 更新 item（OK/NG/Correction/msgId 回填）
    // body: { itemId, status?, reading?, note?, msgId?, cardMsgId? }
    if (request.method === 'PATCH' && url.pathname === '/item') {
      const { itemId, status, reading, note, msgId, cardMsgId } = await request.json();
      const items = (await this.state.storage.get('items')) ?? [];
      const idx   = items.findIndex(i => i.itemId === itemId);
      if (idx === -1) return Response.json({ ok: false, error: 'item not found' });

      if (status   !== undefined) items[idx].status   = status;
      if (reading  !== undefined) items[idx].reading  = reading;
      if (note     !== undefined) items[idx].note     = note;

      // 支持 msgId 或 cardMsgId（两种调用方式）
      const newMsgId = msgId ?? cardMsgId ?? null;
      if (newMsgId) {
        items[idx].msgId     = newMsgId;
        items[idx].cardMsgId = newMsgId;   // 向后兼容
        await this.state.storage.put(`msg:${newMsgId}`, itemId);
      }

      await this.state.storage.put('items', items);
      return Response.json({ ok: true, item: items[idx] });
    }

    // GET /item-by-msg?msgId=xxx — 通过消息 ID 查 item（兼容旧路径 /item-by-card）
    if (request.method === 'GET' &&
        (url.pathname === '/item-by-msg' || url.pathname === '/item-by-card')) {
      const msgId = url.searchParams.get('msgId') ?? url.searchParams.get('cardMsgId');
      if (!msgId) return Response.json({ item: null });
      const itemId = await this.state.storage.get(`msg:${msgId}`);
      if (!itemId) return Response.json({ item: null });
      const items = (await this.state.storage.get('items')) ?? [];
      const item  = items.find(i => i.itemId === itemId) ?? null;
      return Response.json({ item });
    }

    // GET /get-items
    if (request.method === 'GET' && url.pathname === '/get-items') {
      const items = (await this.state.storage.get('items')) ?? [];
      return Response.json({ items });
    }

    // DELETE /reset
    if (request.method === 'DELETE' && url.pathname === '/reset') {
      await this.state.storage.deleteAll();
      return Response.json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  }
}
