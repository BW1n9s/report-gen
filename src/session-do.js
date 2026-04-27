// Durable Object — one instance per chatId, strongly consistent reads/writes
export class SessionDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === '/get') {
      const data = await this.state.storage.get('session');
      return Response.json(data ?? null);
    }

    if (pathname === '/put') {
      const data = await request.json();
      await this.state.storage.put('session', data);
      return Response.json({ ok: true });
    }

    if (pathname === '/delete') {
      await this.state.storage.delete('session');
      return Response.json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  }
}
