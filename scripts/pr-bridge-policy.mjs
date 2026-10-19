export function mainSyncDecision({ equal, aIsAncestor }) {
  if (equal) return 'current';
  return aIsAncestor ? 'fast-forward' : 'stop';
}

export function pairDecision({ merged, closed, sourceClosed, headIncluded }) {
  if (merged) return headIncluded ? 'accepted' : 'new-commits-pending';
  if (closed) return 'rejected';
  if (sourceClosed) return 'withdrawn';
  return 'pending';
}
