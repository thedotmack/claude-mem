import test from 'node:test';
import assert from 'node:assert/strict';
import { productsFromObservation, recordedFile } from '../../../src/services/work-view/work-product.mjs';

test('malformed file-list entries cannot interrupt valid observation products', () => {
  const observation = { id: 9, files_modified: JSON.stringify([null, 42, {}, [], true, '/work/report.pdf']), created_at_epoch: 100 };
  const products = productsFromObservation(observation);
  assert.equal(products.length, 1);
  assert.equal(products[0].path, '/work/report.pdf');
  assert.equal(products[0].sourceRef.index, 5);
});

test('rejected strings leave valid file positions and generic-page titles intact', () => {
  const observation = { id: 9, files_modified: JSON.stringify(['relative.pdf', '/work/a.ts', '/work/../secret.pdf', '/work/review/index.html']) };
  const [product] = productsFromObservation(observation);
  assert.equal(product.title, 'review');
  assert.equal(product.sourceRef.index, 3);
});

test('recorded-file lookup can reach a valid original index after a malformed entry', () => {
  const row = { id: 9, files_modified: JSON.stringify([null, '/work/report.pdf']) };
  const read = sql => sql.includes('PRAGMA') ? [] : [row];
  assert.equal(recordedFile(read, 'observation', 9, 1), '/work/report.pdf');
  assert.equal(recordedFile(read, 'observation', 9, 0), null);
});
