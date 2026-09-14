import { Component } from '@angular/core';

/** PLAN.md section 11, case 10: nested loops, neither one tracked. */
@Component({
  selector: 'app-nested-loops',
  templateUrl: './nested-loops.component.html',
})
export class NestedLoopsComponent {
  rows: { cells: string[] }[] = [];
}
