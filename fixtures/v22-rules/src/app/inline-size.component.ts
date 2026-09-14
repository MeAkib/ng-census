import { Component, ChangeDetectionStrategy, signal } from '@angular/core';

/**
 * A tiny class with a long inline template.
 *
 * classLoc must measure the class body only. Counting from the decorator
 * would fold this template into the class size and count it twice, once here
 * and once in templateLoc.
 */
@Component({
  selector: 'app-inline-size',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section>
      <h1>one</h1>
      <h2>two</h2>
      <h3>three</h3>
      <h4>four</h4>
      <h5>five</h5>
    </section>
  `,
})
export class InlineSizeComponent {
  readonly title = signal('small class, big template');
}
