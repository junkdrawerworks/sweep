// Rooms and settings in the browser's storage (a stand-in localStorage here, with a size limit).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class Storage {
  constructor(limit = 5000) { this.m = new Map(); this.limit = limit; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) {
    const size = [...this.m].reduce((s, [key, val]) => s + (key === k ? 0 : key.length + val.length), 0) + k.length + String(v).length;
    if (size > this.limit) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
    this.m.set(k, String(v));
  }
  removeItem(k) { this.m.delete(k); }
}
globalThis.localStorage = new Storage();
const { loadSettings, saveSettings, listRooms, loadRoom, saveRoom, deleteRoom, newId, DEFAULTS } = await import('../../js/store.js');

beforeEach(() => { globalThis.localStorage = new Storage(); });

test('settings start from the defaults and keep what was changed', () => {
  assert.deepEqual(loadSettings(), DEFAULTS);
  saveSettings({ ...loadSettings(), seconds: 5, units: 'm' });
  const s = loadSettings();
  assert.equal(s.seconds, 5);
  assert.equal(s.units, 'm');
  assert.equal(s.countdown, DEFAULTS.countdown);
});

test('rooms: save, list newest first, load, rename, delete', () => {
  const a = { id: newId(), name: 'Kitchen', updated: 1, looks: [] };
  const b = { id: newId(), name: 'Bedroom', updated: 2, looks: [] };
  saveRoom(a, { w: 6.1, h: 4.9, area: 24.83, outline: [] });
  saveRoom(b, { w: 4.27, h: 4.27, area: 16.74, outline: [] });
  assert.deepEqual(listRooms().map(r => r.name), ['Bedroom', 'Kitchen']);
  assert.equal(listRooms()[1].area, 24.83);
  assert.deepEqual(loadRoom(a.id), a);
  saveRoom({ ...a, name: 'Galley kitchen' }, { w: 6.1, h: 4.9, area: 24.83, outline: [] });
  assert.deepEqual(listRooms().map(r => r.name), ['Galley kitchen', 'Bedroom']);
  deleteRoom(b.id);
  assert.deepEqual(listRooms().map(r => r.name), ['Galley kitchen']);
  assert.equal(loadRoom(b.id), null);
  assert.ok(Object.keys(Object.fromEntries(localStorage.m)).every(k => k.startsWith('sweep.')), 'every key starts with sweep.');
});

test('a full storage says so', () => {
  globalThis.localStorage = new Storage(300);
  assert.throws(() => saveRoom({ id: 'x', name: 'Big', looks: ['y'.repeat(400)] }, {}), /full/);
});

test('damaged storage reads as empty, not as an error', () => {
  localStorage.setItem('sweep.v1.rooms', '{not json');
  assert.deepEqual(listRooms(), []);
  localStorage.setItem('sweep.v1.rooms', '{"a": 1}');
  assert.deepEqual(listRooms(), []);
});
