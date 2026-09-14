import { Component, ChangeDetectionStrategy, signal } from '@angular/core';

@Component({
  selector: 'app-portal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (open()) { <p>portal</p> }`,
})
export class PortalComponent {
  readonly open = signal(true);
}
