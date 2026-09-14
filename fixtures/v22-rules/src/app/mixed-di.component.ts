import { Component, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';

/** PLAN.md section 11, case 9: both DI styles in one class. */
@Component({
  selector: 'app-mixed-di',
  template: `<p>mixed</p>`,
})
export class MixedDiComponent {
  private readonly http = inject(HttpClient);

  constructor(private readonly router: Router) {}
}
