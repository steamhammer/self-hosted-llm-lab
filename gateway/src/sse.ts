/**
 * Minimal Server-Sent Events framing: splits a byte stream into complete events
 * (blocks separated by a blank line). The gateway relays whole events, never partial ones,
 * so it can inspect usage/error chunks without corrupting the stream.
 */
export async function* sseEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    if (buf.includes("\r")) buf = buf.replace(/\r\n/g, "\n");
    for (let i = buf.indexOf("\n\n"); i !== -1; i = buf.indexOf("\n\n")) {
      const event = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (event.trim()) yield event;
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield buf;
}

/** Joined `data:` payload of an event, or null for comment/keep-alive events. */
export function eventData(event: string): string | null {
  const lines: string[] = [];
  for (const line of event.split("\n")) {
    if (line.startsWith("data:")) lines.push(line.slice(line.startsWith("data: ") ? 6 : 5));
  }
  return lines.length ? lines.join("\n") : null;
}

export function sseError(body: object): string {
  return `data: ${JSON.stringify(body)}\n\n`;
}
