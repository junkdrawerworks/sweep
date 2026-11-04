// Lengths and areas as people write them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtLength, fmtArea, fmtSize, parseLength, defaultUnits, INCH } from '../../js/units.js';

test('feet and inches, to the nearest inch', () => {
  assert.equal(fmtLength(148 * INCH), '12′ 4″');
  assert.equal(fmtLength(12 * INCH), '1′ 0″');
  assert.equal(fmtLength(0.2), '8″');
  assert.equal(fmtLength(4.57), '15′ 0″');
  assert.equal(fmtLength(143.6 * INCH), '12′ 0″'); // rounds up into the next foot
  assert.equal(fmtLength(NaN), '–');
});

test('metres to the centimetre, centimetres under a metre', () => {
  assert.equal(fmtLength(3.756, 'm'), '3.76 m');
  assert.equal(fmtLength(0.854, 'm'), '85 cm');
  assert.equal(fmtLength(1, 'm'), '1.00 m');
});

test('areas and sizes', () => {
  assert.equal(fmtArea(26.46), '285 sq ft');
  assert.equal(fmtArea(26.46, 'm'), '26.5 m²');
  assert.equal(fmtArea(200), '2,153 sq ft');
  assert.equal(fmtSize(4.57, 5.79), '15′ 0″ × 19′ 0″');
  assert.equal(fmtSize(4.57, 5.79, 'm'), '4.57 m × 5.79 m');
});

test('reading what someone typed from a tape measure', () => {
  const ft = 12 * INCH;
  const cases = [
    [`12' 4"`, 148 * INCH], ['12ft 4in', 148 * INCH], [`12'4`, 148 * INCH], ['12′ 4″', 148 * INCH], ['12’ 4”', 148 * INCH],
    ['148"', 148 * INCH], ['148 in', 148 * INCH], [`12.5'`, 12.5 * ft], ['12', 12 * ft],
    ['3.76 m', 3.76], ['376 cm', 3.76], ['3760 mm', 3.76], ['3,76 m', 3.76],
  ];
  for (const [text, want] of cases) {
    const got = parseLength(text);
    assert.ok(got !== null && Math.abs(got - want) < 1e-9, `${text}: ${got} against ${want}`);
  }
  assert.equal(parseLength('3.76', 'm'), 3.76);
  for (const junk of ['', '   ', 'twelve feet', '12 furlongs', '-3 m', null]) assert.equal(parseLength(junk), null, String(junk));
});

test('feet in the US, metres elsewhere', () => {
  assert.equal(defaultUnits('en-US'), 'ft');
  assert.equal(defaultUnits('en-GB'), 'm');
  assert.equal(defaultUnits('fr-FR'), 'm');
  assert.equal(defaultUnits('en-CA'), 'm');
});
