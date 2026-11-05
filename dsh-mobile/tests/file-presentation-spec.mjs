import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, loadSource } from './support/component-harness.mjs';
const { fileTypeLabel } = loadSource('core/filePresentation.ts');
const longName = '交付验收报告最终修订版'.repeat(12) + '.docx';

test('file type labels handle paths, hidden files and unknown extensions', () => {
  for (const [name, label] of [['report.DOCX','DOCX'],['E:\\reports\\预算.xlsx','XLSX'],['a/b/export.csv','CSV'],['archive.tar.gz','GZ'],['notes.md','MD'],['README','文件'],['.env','文件'],['report.','文件'],['file.unknownextension','文件'],['file.文档','文件'],[undefined,'文件']]) {
    assert.equal(fileTypeLabel(name), label, String(name));
  }
});

test('shared badge renders the original extension at either card size', () => {
  const h = componentHarness('components/FileTypeBadge.tsx', 'FileTypeBadge', { name: longName });
  assert.match(h.text(), /DOCX/);
  assert.equal(h.find(n => n.type === 'View').props.style.width, 40);
  h.render({ compact: true });assert.equal(h.find(n => n.type === 'View').props.style.width, 32);
  assert.match(h.text(), /DOCX/);
});

test('history file chips preserve the complete name and share the type badge', () => {
  const h = componentHarness('components/Attachment.tsx', 'AttachmentGallery', { sessionId: 'local', api: {}, parts: [
    { kind: 'file', attachmentId: 'f1', name: longName, bytes: 234 },
  ] }, {
    './ImageViewer': { ImageViewer: 'ImageViewer' },
    './useAttachmentImages': { useAttachmentImages: () => ({ statuses: [], retry() {}, failed() {} }) },
    '../core/picker': { formatBytes: n => n === undefined ? '' : `${n} B` },
  });
  const name = h.find(n => n.type === 'Text' && n.children.includes(longName));
  assert.equal(name.props.ellipsizeMode, 'middle');assert.notEqual(name.props.selectable, true, 'Android selectable Text does not reliably apply middle ellipsis');
  assert.match(h.text(), /DOCX/);assert.match(h.text(), /234 B/);
  assert.ok(h.nodes().some(n => n.props.accessibilityLabel?.includes(longName)));
});

test('delivered file title keeps the real filename when a description is supplied', () => {
  const h = componentHarness('components/FileCard.tsx', 'FileCard', { path: 'reports/' + longName, alt: '这是交付说明', expectedSize: 234 }, {
    'react-native-blob-util': { default: { fs: {} } },
    '../App': { useApp: () => ({ store: {}, butlerWorkspace: '/local' }) },
    '../core/fileUrl': { fetchRemoteFile() { assert.fail('Rendering must not download regular files'); }, openLocalFile() {} },
    '../core/gatewayFiles': { downloadWorkspaceFile() {} },
    './ImageViewer': { ImageViewer: 'ImageViewer' },
    './DocumentViewer': { DocumentViewer: 'DocumentViewer', canPreviewInside: () => true },
    '../core/picker': { formatBytes: n => `${n} B` },
  });
  const name = h.find(n => n.type === 'Text' && n.children.includes(longName));
  assert.equal(name.props.ellipsizeMode, 'middle');assert.match(h.text(), /这是交付说明/);
  assert.match(h.text(), /DOCX/);assert.match(h.text(), /234 B/);
  assert.ok(h.nodes().some(n => n.props.accessibilityLabel === `打开 ${longName}，这是交付说明`));
});

test('pending attachment labels preserve unknown-send safety and retry identity', () => {
  const record = { state: 'unknown', text: 'local test', updatedAt: 0, attemptCount: 1,
    attachments: [{ kind: 'file', name: longName, stagedUri: 'private://one' }], lastError: { classification: 'unknown' } };
  let retried;
  const h = componentHarness('components/PendingSendBubble.tsx', 'PendingSendBubble', {
    record, onRetry: value => { retried = value; }, onRemove: () => assert.fail('Unknown sends must not be removed'),
  });
  assert.match(h.text(), /结果未知，可能已在电脑执行/);assert.match(h.text(), /DOCX/);
  assert.equal(h.find(n => n.type === 'Text' && n.children.includes(longName)).props.ellipsizeMode, 'middle');
  assert.doesNotMatch(h.text(), /移除/);
  const retry = h.find(n => n.type === 'Pressable' && n.children.some(c => c?.children?.includes('安全重试（复用原 ID）')));
  retry.props.onPress();assert.equal(retried, record);
});
