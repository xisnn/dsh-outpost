import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cachedImageUri, imageFailed, loadImageUri } from '../core/attachment-cache';
import type { UploadApi } from '../core/rpc/upload';
import type { AttachRef } from '../core/types';
export type AttachmentImage = Extract<AttachRef, { kind: 'image' }>;
interface ImageStatus { phase: 'loading' | 'ready' | 'failed'; uri?: string }

/** Keep view state scoped too: late results cannot replace another connection/session's images. */
export function useAttachmentImages(api: UploadApi, sessionId: string, images: readonly AttachmentImage[]) {
  const signature = JSON.stringify(images.map(image => [image.attachmentId, image.localUri]));
  const scope = useMemo(() => ({ api, sessionId, signature }), [api, sessionId, signature]);
  const initial = useMemo(() => images.map((image): ImageStatus => {
    const uri = image.localUri ?? cachedImageUri(sessionId, image.attachmentId, api);
    return uri ? { phase: 'ready', uri } : { phase: imageFailed(image.attachmentId, sessionId, api) ? 'failed' : 'loading' };
  }), [scope]);
  const [state, setState] = useState({ scope, values: initial });
  const lifetime = useRef<{ scope: typeof scope; active: boolean; pending: Set<number> } | null>(null);
  const update = useCallback((index: number, value: ImageStatus) => {
    setState(previous => previous.scope !== scope ? previous : {
      scope, values: previous.values.map((old, i) => i === index ? value : old),
    });
  }, [scope]);
  useEffect(() => {
    const request = { scope, active: true, pending: new Set<number>() };
    lifetime.current = request; setState({ scope, values: initial });
    images.forEach((image, index) => {
      if (initial[index].phase !== 'loading') return;
      request.pending.add(index);
      void loadImageUri(api, sessionId, image.attachmentId).then(uri => {
        request.pending.delete(index);
        if (request.active && lifetime.current === request) update(index, uri ? { phase: 'ready', uri } : { phase: 'failed' });
      });
    });
    return () => { request.active = false; request.pending.clear(); };
  }, [scope, initial, update]);
  const retry = useCallback((index: number) => {
    const request = lifetime.current;
    if (!request?.active || request.scope !== scope || request.pending.has(index) || !images[index]) return;
    request.pending.add(index); update(index, { phase: 'loading' });
    void loadImageUri(api, sessionId, images[index].attachmentId, { retry: true }).then(uri => {
      request.pending.delete(index);
      if (request.active && lifetime.current === request) update(index, uri ? { phase: 'ready', uri } : { phase: 'failed' });
    });
  }, [scope, update]);
  const failed = useCallback((index: number, uri: string) => {
    if (!lifetime.current?.active || lifetime.current.scope !== scope) return;
    setState(previous => previous.scope !== scope || previous.values[index]?.uri !== uri ? previous : {
      scope, values: previous.values.map((old, i) => i === index ? { phase: 'failed' } : old),
    });
  }, [scope]);
  return { statuses: state.scope === scope ? state.values : initial, retry, failed };
}
