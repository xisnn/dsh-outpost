import test from 'node:test';
import assert from 'node:assert/strict';
import {mentionAt, insertReference} from '../src/core/mentionDraft.ts';
const caret = n => ({start:n,end:n});
test('references trigger at a token boundary, never inside email or a closed reference', () => {
  for (const text of ['@', '看 @src', '（@路径', '(@文件']) assert.ok(mentionAt(text, caret(text.length)));
  for (const text of ['me@example.com', '@"a b.txt" ', '@[reply](dsh-session:InMi) ', 'a@src']) assert.equal(mentionAt(text,caret(text.length)),null);
  assert.equal(mentionAt('@src',{start:0,end:4}),null);
  assert.equal(mentionAt('@'+'a'.repeat(501),caret(502)),null);
});
test('quoted paths containing @ retain their exact range and suffix', () => {
  const text = '请看 @"my @dir/a 以及后文';
  const end = text.indexOf(' 以及');
  const range = mentionAt(text,caret(end));
  assert.deepEqual(range,{start:3,end,query:'my @dir/a'});
  const next = insertReference(text,caret(end),'@"my @dir/a.ts"',range);
  assert.equal(next.text,'请看 @"my @dir/a.ts"  以及后文');
  assert.equal(next.selection.start,'请看 @"my @dir/a.ts" '.length);
});
test('directory insertion keeps quoted completion open; file selection closes and separates it', () => {
  let text = '@my';
  let next = insertReference(text,caret(text.length),'@"my dir/',mentionAt(text,caret(text.length)),20000,true);
  assert.equal(next.text,'@"my dir/');
  assert.equal(mentionAt(next.text,next.selection).query,'my dir/');
  text=next.text;
  next=insertReference(text,next.selection,'@"my dir/中文.ts"',mentionAt(text,next.selection));
  assert.equal(next.text,'@"my dir/中文.ts" ');
  assert.equal(mentionAt(next.text,next.selection),null);
});
test('manual reference replaces a selection without erasing surrounding draft and refuses overflow', () => {
  assert.equal(insertReference('before old after',{start:7,end:10},'@new').text,'before @new  after');
  assert.equal(insertReference('keep',caret(4),'@file').text,'keep @file ');
  assert.throws(()=>insertReference('draft',caret(5),'@file',undefined,8),/草稿上限/);
  assert.throws(()=>insertReference('draft',caret(8),'@file'),/位置已变化/);
  assert.throws(()=>insertReference('',caret(0),'@bad\npath'),/格式/);
});
