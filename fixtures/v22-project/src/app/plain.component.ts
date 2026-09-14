import { Component } from '@angular/core';

/**
 * The version-pair fixture. This exact file exists in both the v18 and v22
 * projects. The `standalone` flag is absent in both.
 *
 * On v22 absence means standalone. On v18 absence means NOT standalone.
 * Same bytes, opposite meaning. If the tool reports the same answer for both,
 * version handling is broken.
 */
@Component({
  selector: 'app-plain',
  template: '<p>plain</p>',
})
export class PlainComponent {}
