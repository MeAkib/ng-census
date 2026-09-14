import { Component } from '@angular/core';

/**
 * Exercises the template rule catalog. Every legacy pattern here is one an AI
 * agent writes by habit, because it dominates pre-2023 training data.
 */
@Component({
  selector: 'app-legacy-template',
  templateUrl: './legacy-template.component.html',
})
export class LegacyTemplateComponent {
  items: { id: string; name: string }[] = [];
  mode = 'a';
  html = '<b>unsafe</b>';
  stream$ = null;

  getLabel(): string {
    return 'label';
  }
}
