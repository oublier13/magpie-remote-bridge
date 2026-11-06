'use strict';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

class Clock {
  constructor() { this.now = 0; this.timers = new Set(); }
  setTimeout(fn, ms) {
    const timer = { fn, due: this.now + ms, unref() {} };
    this.timers.add(timer);
    return timer;
  }
  clearTimeout(timer) { this.timers.delete(timer); }
  async advance(ms) {
    const end = this.now + ms;
    for (;;) {
      const timer = [...this.timers].filter(t => t.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!timer) break;
      this.now = timer.due;
      this.timers.delete(timer);
      timer.fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

module.exports = { Clock };
