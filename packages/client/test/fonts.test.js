import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFontLoader, familiesIn, googleFontsUrl } from '../src/fonts.js';

test('reads the named families out of a font-family list, leaving generics and odd names out', () => {
  assert.deepEqual(familiesIn('"Fraunces", Georgia, serif'), ['Fraunces', 'Georgia']);
  assert.deepEqual(familiesIn("'Space Grotesk', system-ui, sans-serif"), ['Space Grotesk']);
  assert.deepEqual(familiesIn('var(--ed-font), sans-serif'), []);
  assert.deepEqual(familiesIn('"Evil); @import url(x"'), []);
  assert.deepEqual(familiesIn(42), []);
});

test('only ever builds a fonts.googleapis.com URL, with the name as a query value', () => {
  assert.equal(googleFontsUrl('Space Grotesk'), 'https://fonts.googleapis.com/css2?family=Space+Grotesk&display=swap');
  assert.equal(googleFontsUrl('../../evil'), null);
  assert.equal(googleFontsUrl('a&b=c'), null);
});

/** A page with a head, and the fonts its own stylesheets declare. */
function fakePage(declared = []) {
  const head = { children: [], append: (el) => head.children.push(el) };
  const document = {
    head,
    fonts: declared.map((family) => ({ family })),
    createElement: () => {
      const el = { dataset: {}, remove: () => head.children.splice(head.children.indexOf(el), 1) };

      return el;
    },
  };

  return { document, head };
}

test('requests each new family once, and never one the page already has', () => {
  const page = fakePage(['"Montserrat"', 'League Gothic']);
  const fonts = createFontLoader({ document: page.document });
  assert.deepEqual(fonts.ensure('"Fraunces", "Montserrat", serif'), ['Fraunces']);
  assert.deepEqual(fonts.ensure('"Fraunces", sans-serif'), []);
  assert.deepEqual(fonts.ensure('"League Gothic", sans-serif'), []);
  assert.equal(page.head.children.length, 1);
  assert.equal(page.head.children[0].rel, 'stylesheet');
  assert.match(page.head.children[0].href, /^https:\/\/fonts\.googleapis\.com\/css2\?family=Fraunces/);
});

test('leaving the room takes the fonts back out', () => {
  const page = fakePage();
  const fonts = createFontLoader({ document: page.document });
  fonts.ensure('"Fraunces", serif');
  fonts.ensure('"Inter", sans-serif');
  fonts.remove();
  assert.equal(page.head.children.length, 0);
});
