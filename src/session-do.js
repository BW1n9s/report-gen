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
        type:          'image',
        check_id:      payload.check_id,
        reading:       payload.reading,
        status:        'pending',
        note:          null,
        imageKey:      payload.imageKey,
        msgId:         payload.msgId ?? null,
        cardMsgId:     payload.msgId ?? null,   // 向后兼容（card actions 还用这个查）
        originalMsgId: payload.originalMsgId ?? null,
        timestamp:     new Date().toISOString(),
      });
      await this.state.storage.put('items', items);

      if (payload.msgId) {
        await this.state.storage.put(`msg:${payload.msgId}`, itemId);
      }

      // Return the count of image-type items only so the "已分析 N 张" display
      // isn't inflated by the many individual handwritten sub-items.
      const imageCount = items.filter(i => i.type === 'image').length;
      return Response.json({ count: imageCount, itemId });
    }

    // POST /results-bulk — bulk insert handwritten-PDI items (no msgId/dedup)
    // body: { items: [{ check_id, reading, status, imageKey, originalMsgId }] }
    // response: { count, addedCount }
    if (request.method === 'POST' && url.pathname === '/results-bulk') {
      const { items: newItems } = await request.json();
      if (!Array.isArray(newItems) || newItems.length === 0) {
        return Response.json({ count: 0, addedCount: 0 });
      }
      const items = (await this.state.storage.get('items')) ?? [];
      const now   = new Date().toISOString();
      let added   = 0;
      for (const payload of newItems) {
        const itemId = `item_${Date.now()}_${items.length}_${added}`;
        items.push({
          itemId,
          type:          'handwritten',
          check_id:      payload.check_id,
          reading:       payload.reading  ?? '',
          status:        payload.status   ?? 'ok',
          note:          payload.note     ?? null,
          imageKey:      payload.imageKey ?? null,
          msgId:         null,
          cardMsgId:     null,
          originalMsgId: payload.originalMsgId ?? null,
          timestamp:     now,
        });
        added++;
      }
      await this.state.storage.put('items', items);
      return Response.json({ count: items.length, addedCount: added });
    }

    // PATCH /item — 更新 item（OK/NG/Correction/msgId 回填）
    // body: { itemId, status?, reading?, note?, msgId?, cardMsgId? }
    if (request.method === 'PATCH' && url.pathname === '/item') {
      const { itemId, status, reading, note, check_id, msgId, cardMsgId } = await request.json();
      const items = (await this.state.storage.get('items')) ?? [];
      const idx   = items.findIndex(i => i.itemId === itemId);
      if (idx === -1) return Response.json({ ok: false, error: 'item not found' });

      if (status   !== undefined) items[idx].status   = status;
      if (reading  !== undefined) items[idx].reading  = reading;
      if (note     !== undefined) items[idx].note     = note;
      if (check_id !== undefined) items[idx].check_id = check_id;

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
      const items   = (await this.state.storage.get('items')) ?? [];
      const pending = (await this.state.storage.get('pending-events')) ?? [];
      const imageCount = items.filter(i => i.type === 'image').length;
      return Response.json({ items, pendingCount: pending.length, imageCount });
    }

    // DELETE /reset
    if (request.method === 'DELETE' && url.pathname === '/reset') {
      await this.state.storage.deleteAll();
      return Response.json({ ok: true });
    }

    // POST /queue-event — store event for alarm-based deferred processing
    if (request.method === 'POST' && url.pathname === '/queue-event') {
      const event = await request.json();
      const pending = (await this.state.storage.get('pending-events')) ?? [];
      pending.push(event);
      await this.state.storage.put('pending-events', pending);
      // Only schedule alarm if none is already pending
      const existing = await this.state.storage.getAlarm();
      if (!existing) {
        await this.state.storage.setAlarm(Date.now() + 300);
      }
      return Response.json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  }

  // Alarm fires in a fresh execution context — no waitUntil time limit inherited.
  // Process one event per alarm so a slow Claude call never blocks subsequent events.
  async alarm() {
    const pending = (await this.state.storage.get('pending-events')) ?? [];
    if (pending.length === 0) return;

    const [event, ...remaining] = pending;
    await this.state.storage.put('pending-events', remaining);

    // Reschedule immediately so the next event starts as soon as this one finishes
    if (remaining.length > 0) {
      await this.state.storage.setAlarm(Date.now() + 100);
    }

    const env = this.env;
    const { routeMessage, routeCardAction } = await import('./router.js');

    try {
      const eventId = event.header?.event_id;
      if (eventId) {
        const seen = await env.REPORT_SESSIONS.get(`event:${eventId}`);
        if (seen) return;
        await env.REPORT_SESSIONS.put(`event:${eventId}`, '1', { expirationTtl: 86400 });
      }
      const eventType = event.header?.event_type;
      if (eventType === 'im.message.receive_v1') {
        await routeMessage(event, env);
      } else if (eventType === 'card.action.trigger') {
        await routeCardAction(event, env);
      }
    } catch (err) {
      console.error('[DO alarm] error processing event:', err);
    }
  }
}
