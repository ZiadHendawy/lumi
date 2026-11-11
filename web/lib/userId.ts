// Anonymous identity: a random id kept in this browser, so memory works with no login.
// Clearing site data (or switching browsers) starts a fresh user.
const KEY = 'lumi.userId';

export function getUserId(): string {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}
