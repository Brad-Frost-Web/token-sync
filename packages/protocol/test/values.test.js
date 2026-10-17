import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSafety, checkValue, inferType } from '../src/values.js';

test('refuses the values the spec names (Q18)', () => {
  for (const value of [
    'url(https://example.com/x.png)',
    'URL( "x" )',
    'red; background: blue',
    'red}body{color:red',
    '{',
    'red !important',
    'red ! IMPORTANT',
  ]) {
    assert.equal(checkSafety(value).ok, false, value);
  }
});

test('refuses the ways around the refusal list', () => {
  // A CSS escape spells url( without the letters u-r-l.
  assert.equal(checkSafety('u\\72l(x)').ok, false);
  // Functions that fetch are not on the allowlist.
  assert.equal(checkSafety('image-set("a.png" 1x)').ok, false);
  assert.equal(checkSafety('src("a.png")').ok, false);
  assert.equal(checkSafety('expression(alert(1))').ok, false);
  // Newlines and non-ASCII.
  assert.equal(checkSafety('red\nblue').ok, false);
  assert.equal(checkSafety('ｕrl(x)').ok, false);
  // Markup and at-rules.
  assert.equal(checkSafety('</style>').ok, false);
  assert.equal(checkSafety('@import').ok, false);
  // Unbalanced input that could swallow what follows it.
  assert.equal(checkSafety('rgb(1, 2, 3').ok, false);
  assert.equal(checkSafety('"Inter').ok, false);
  // Not strings, empty, oversized.
  assert.equal(checkSafety(12).ok, false);
  assert.equal(checkSafety('').ok, false);
  assert.equal(checkSafety('a'.repeat(201)).ok, false);
});

test('accepts ordinary token values', () => {
  for (const value of ['#f05735', 'oklch(70% 0.1 200)', 'calc(1rem + 2px)', 'var(--ed-color-brand-orange-800)', '"Inter", sans-serif', '1.5']) {
    assert.equal(checkSafety(value).ok, true, value);
  }
});

test('colours must parse as colours', () => {
  for (const value of ['#fff', '#ffffff80', 'rebeccapurple', 'transparent', 'rgb(0 0 0 / 50%)', 'oklch(60% 0.2 30)', 'color-mix(in oklch, red, blue)']) {
    assert.equal(checkValue(value, 'color').ok, true, value);
  }
  for (const value of ['12px', 'notacolor', '#ggg', 'calc(1px)']) {
    assert.equal(checkValue(value, 'color').ok, false, value);
  }
});

test('lengths must parse as lengths', () => {
  for (const value of ['0', '4px', '1.25rem', '-2em', '50%', 'clamp(1rem, 2vw, 2rem)', 'calc(100% - 2px)']) {
    assert.equal(checkValue(value, 'length').ok, true, value);
  }
  for (const value of ['red', '4', 'px', '#fff']) {
    assert.equal(checkValue(value, 'length').ok, false, value);
  }
});

test('a var() reference is valid for every type', () => {
  for (const type of ['color', 'length', 'number', 'font-family', 'any']) {
    assert.equal(checkValue('var(--other-token)', type).ok, true, type);
  }
});

test('type checks still apply the safety refusals', () => {
  assert.equal(checkValue('red !important', 'color').ok, false);
  assert.equal(checkValue('url(x)', 'any').ok, false);
});

test('infers the type from the value a property holds now', () => {
  assert.equal(inferType('#be6700'), 'color');
  assert.equal(inferType(' rgb(1, 2, 3) '), 'color');
  assert.equal(inferType('0.5rem'), 'length');
  assert.equal(inferType('700'), 'number');
  assert.equal(inferType('"Inter", sans-serif'), 'any');
  assert.equal(inferType(''), 'any');
  assert.equal(inferType(undefined), 'any');
});

test('a colour or length followed by junk is not a colour or length', () => {
  assert.equal(checkValue('rgb(0 0 0) calc(1px)', 'color').ok, false);
  assert.equal(checkValue('calc(1px) red', 'length').ok, false);
});

test('an apostrophe inside double quotes is just a character', () => {
  assert.equal(checkSafety('"it\'s", serif').ok, true);
  assert.equal(checkSafety('"it\'s').ok, false);
});
