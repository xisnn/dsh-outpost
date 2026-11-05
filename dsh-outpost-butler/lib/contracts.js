/**
 * Fail closed when the installed DSH does not expose the 0.2.x contracts this
 * bundle was written against. DSH has no protocol-version negotiation for
 * these internal services, so a missing method must stop the plugin instead of
 * failing later in the middle of a task.
 */
export function assertButlerContracts(ctx) {
  const missing = [];

  const requireMethods = (label, service, methods) => {
    if (!service) {
      missing.push(label);
      return;
    }
    for (const method of methods) {
      if (typeof service[method] !== 'function') missing.push(`${label}.${method}`);
    }
  };

  requireMethods('goals', ctx.goals, ['create', 'get', 'pause', 'resume']);
  requireMethods('sessionController', ctx.sessionController, ['create', 'resolveAgent']);
  requireMethods('agents', ctx.agents, ['get']);
  requireMethods('storageDomain', ctx.storageDomain, ['open']);
  if (typeof ctx.connection?.fetch?.register !== 'function') {
    missing.push('connection.fetch.register');
  }

  if (missing.length > 0) {
    throw new Error(
      `[outpost-butler] incompatible DSH: missing ${missing.join(', ')}. ` +
        'This bundle targets DSH 0.2.x; re-check the contract after a DSH upgrade.',
    );
  }
}
