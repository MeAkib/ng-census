import { Component } from '@angular/core';

class Base {
  protected ready = true;
}

/**
 * `constructor() { super(); }` is usually redundant, but whether it is depends
 * on the parent class — another file, in real code. The rule must not guess.
 */
@Component({
  selector: 'app-super-call',
  template: `<p>super</p>`,
})
export class SuperCallComponent extends Base {
  constructor() {
    super();
  }
}
