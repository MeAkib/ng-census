import { Component, OnChanges, OnDestroy, OnInit } from '@angular/core';

/**
 * Generator leftovers, next to the cases that must not be flagged.
 *
 * Older Angular CLI versions produced `constructor() {}` and an empty
 * `ngOnInit` in every component, and agents still write them by habit.
 */
@Component({
  selector: 'app-scaffold',
  template: `<p>scaffold</p>`,
})
export class ScaffoldComponent implements OnInit, OnChanges, OnDestroy {
  constructor() {}

  // Empty: no statements.
  ngOnInit(): void {}

  // Empty too. A comment does not run.
  ngOnChanges(): void {
    // TODO: react to input changes
  }

  // Not empty.
  ngOnDestroy(): void {
    console.log('destroyed');
  }

  // Not a lifecycle hook, so not this rule's business even though it is empty.
  refresh(): void {}
}
