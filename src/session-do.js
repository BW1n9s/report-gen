export class ImageDedupDO {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // POST /check — 去重 + 注册 session 上下文
    if (request.method === 'POST' && url.pathname === '/check') {
      const { imageKey, chatId, userId } = await request.json();
      if (!imageKey) return Response.json({ isNew: false });

      const seen = await this.state.storage.get(`img:${imageKey}`);
      if (seen) return Response.json({ isNew: false });

      await this.state.storage.put(`img:${imageKey}`, Date.now());

      // 首张图注册 chatId
      const existingChat = await this.state.storage.get('chatId');
      if (chatId && !existingChat) {
        await this.state.storage.put('chatId', chatId);
        await this.state.storage.put('userId', userId ?? '');
      }

      // 清理 24h 前的旧 img: 记录（仅在超过 100 条时触发）
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

    // POST /result — 存结果，更新卡片，重置 alarm
    if (request.method === 'POST' && url.pathname === '/result') {
      const payload = await request.json();

      const results = (await this.state.storage.get('results')) ?? [];
      results.push({
        check_id: payload.check_id,
        status:   payload.status,
        reading:  payload.reading,
      });
      await this.state.storage.put('results', results);

      // 更新车辆信息（铭牌识别后）
      if (payload.vehicle) {
        await this.state.storage.put('vehicle', payload.vehicle);
      }

      // 创建或更新进度卡片
      await this.upsertCard(results, false);

      // 重置 alarm：最后一张处理完 8s 后触发
      await this.state.storage.setAlarm(Date.now() + 8000);

      return Response.json({ ok: true });
    }

    // DELETE /reset — session 结束时清空
    if (request.method === 'DELETE' && url.pathname === '/reset') {
      await this.state.storage.deleteAll();
      return Response.json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  }

  // alarm：最后一张图处理完 8s 后触发
  async alarm() {
    const results = (await this.state.storage.get('results')) ?? [];
    const chatId  = await this.state.storage.get('chatId');
    if (!chatId || results.length === 0) return;

    // 更新卡片为完成状态
    await this.upsertCard(results, true);

    // 发文字通知
    const token = await this.getLarkToken();
    await fetch(`${this.env.LARK_API_URL}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type:   'text',
        content:    JSON.stringify({
          text: `✅ ${results.length} 张照片已全部分析完成，发送「结束」生成报告。`,
        }),
      }),
    });
  }

  // 创建或更新进度卡片
  async upsertCard(results, isDone) {
    const chatId    = await this.state.storage.get('chatId');
    const cardMsgId = await this.state.storage.get('cardMsgId');
    const vehicle   = await this.state.storage.get('vehicle');
    if (!chatId) return;

    const card  = this.buildCard(results, isDone, vehicle);
    const token = await this.getLarkToken();

    if (!cardMsgId) {
      // 首次：发送新卡片
      const res = await fetch(
        `${this.env.LARK_API_URL}/im/v1/messages?receive_id_type=chat_id`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            receive_id: chatId,
            msg_type:   'interactive',
            content:    JSON.stringify(card),
          }),
        },
      );
      const data = await res.json();
      const newId = data.data?.message_id;
      if (newId) await this.state.storage.put('cardMsgId', newId);
    } else {
      // 后续：更新现有卡片
      await fetch(
        `${this.env.LARK_API_URL}/im/v1/messages/${cardMsgId}/content`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ content: JSON.stringify(card) }),
        },
      );
    }
  }

  buildCard(results, isDone, vehicle) {
    const count = results.length;

    // 文字进度条（10格）
    const filled = Math.min(count, 10);
    const bar    = '█'.repeat(filled) + '░'.repeat(10 - filled);

    // 车辆标题行
    const vehicleLine = vehicle?.model
      ? `**${vehicle.model}${vehicle.serial ? ' | S/N: ' + vehicle.serial : ''}**\n`
      : '';

    const STATUS_ICON = {
      ok: '✓', low: '⚠', leak: '⚠', dirty: '⚠',
      missing: '✗', unreadable: '—', 'n/a': 'N/A', noted: '✓',
    };
    const LABEL = {
      attachment_accessories:  '附件',
      visual_structure:        '外观',
      fluid_levels:            '油液',
      engine_mechanical:       '发动机',
      electrical_system:       '电气',
      hydraulic_system:        '液压',
      mast_fork_chain:         '门架链条',
      loader_arm_axle:         '大臂车桥',
      steering_brake_dynamic:  '转向刹车',
      tyre_wheel:              '轮胎',
      safety_functions:        '安全',
      maintenance_work:        '保养',
      final_result:            '最终结果',
      nameplate:               '铭牌',
      general:                 '其他',
    };

    const resultLines = results
      .filter(r => r.check_id !== 'nameplate')
      .map(r => {
        const icon  = STATUS_ICON[r.status] ?? '•';
        const label = LABEL[r.check_id] ?? r.check_id;
        const text  = r.reading ? ` → ${r.reading}` : '';
        return `${icon} **${label}**${text}`;
      })
      .join('\n');

    const bodyMd = [
      vehicleLine,
      `\`${bar}\`  ${count} 张`,
      '',
      resultLines || '_处理中…_',
    ].join('\n');

    return {
      config: { wide_screen_mode: true },
      header: {
        title:    { tag: 'plain_text', content: isDone ? `✅ 全部 ${count} 张已完成` : `📸 已分析 ${count} 张` },
        template: isDone ? 'green' : 'blue',
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: bodyMd } },
        { tag: 'hr' },
        {
          tag: 'note',
          elements: [{
            tag:     'plain_text',
            content: isDone ? '发送「结束」生成完整报告' : '照片处理中，完成后可发送「结束」',
          }],
        },
      ],
    };
  }

  async getLarkToken() {
    const res = await fetch(
      `${this.env.LARK_API_URL}/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id:     this.env.FEISHU_APP_ID,
          app_secret: this.env.FEISHU_APP_SECRET,
        }),
      },
    );
    const data = await res.json();
    if (data.code !== 0) throw new Error(`DO getLarkToken failed: ${data.msg}`);
    return data.tenant_access_token;
  }
}
