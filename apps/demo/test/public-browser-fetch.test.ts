import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { publicBrowserFetch } from '../src/public-browser-fetch';

it('pins the validated socket address and refuses a redirect to the private network', async () => {
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocks.request.mockImplementation((_url, options, respond) => {
    const pinned = vi.fn(); options.lookup('example.com', {}, pinned);
    expect(pinned).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    const request = new EventEmitter() as EventEmitter & { end(): void };
    request.end = () => {
      const response = Object.assign(new EventEmitter(), { statusCode: 302, headers: { location: 'https://127.0.0.1/private' } });
      respond(response); response.emit('end');
    };
    return request;
  });
  await expect(publicBrowserFetch('https://example.com')).rejects.toThrow('Private');
  expect(mocks.request).toHaveBeenCalledTimes(1);
  mocks.lookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
  await expect(publicBrowserFetch('https://rebind.example')).rejects.toThrow('Private');
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
