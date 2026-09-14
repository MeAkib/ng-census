import { Component } from '@angular/core';

@Component({
  selector: 'app-invoice',
  template: `<div *ngIf="due">invoice</div>`,
})
export class InvoiceComponent {
  due = true;
}
