import { Component, EventEmitter, Input, Output, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

/**
 * Every legacy pattern the catalogue names for a component, in one class.
 *
 * The input is written as a setter on purpose: that form is a
 * SetAccessorDeclaration, not a PropertyDeclaration, and an analyzer that
 * only walks properties reports zero inputs for it.
 */
@Component({
  selector: 'app-old-style',
  standalone: false,
  template: `<div [innerHtml]="html"></div>`,
})
export class OldStyleComponent implements OnDestroy {
  private readonly destroy$ = new Subject<void>();
  readonly state$ = new BehaviorSubject<number>(0);
  html = '<b>raw</b>';

  private current = 0;

  @Input() set value(next: number) {
    this.current = next;
  }

  @Output() changed = new EventEmitter<number>();

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
