import { Component, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'lib-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button><ng-content /></button>`,
})
export class ButtonComponent {}
