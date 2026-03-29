import { describe, expect, it } from 'vitest';
import { RealtimeEventsHub } from '../src/realtimeEvents';

describe('RealtimeEventsHub', () => {
  it('stores recent events and broadcasts to subscribers', () => {
    const hub = new RealtimeEventsHub(3);
    const received: string[] = [];

    const unsubscribe = hub.subscribe((event) => {
      received.push(event.type);
    });

    hub.publish('one', { value: 1 });
    hub.publish('two', { value: 2 });
    hub.publish('three', { value: 3 });
    hub.publish('four', { value: 4 });

    unsubscribe();

    expect(received).toEqual(['one', 'two', 'three', 'four']);
    expect(hub.listRecent(10).map((event) => event.type)).toEqual(['two', 'three', 'four']);
    expect(hub.listenerCount()).toBe(0);
  });
});
