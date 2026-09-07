/**
 * Thrown by a handler to jump straight to a redirect -- used for "you are not
 * signed in" and for post/redirect/get after a successful mutation.
 */
export class RedirectSignal extends Error {
  constructor(readonly location: string) {
    super(`redirect:${location}`);
    this.name = 'RedirectSignal';
  }
}
