import { Component } from '@angular/core';

/**
 * Points at a template file that does not exist — a normal state in a repo
 * mid-refactor. It must report templateResolved: false and null template
 * metrics, not zeros, and must not take the rest of the run down with it.
 */
@Component({
  selector: 'app-broken',
  templateUrl: './does-not-exist.component.html',
})
export class BrokenTemplateComponent {}
