import { Component } from '@angular/core';

/**
 * Angular 16 predates @if / @for / @defer entirely. Their counters must come
 * back null, never 0 — zero would mean "we looked and found none", which reads
 * on a chart as a project failing at something it could not have done.
 */
@Component({
  selector: 'app-old',
  template: '<div *ngIf="x">{{ x }}</div>',
})
export class OldComponent {
  x = true;
}
