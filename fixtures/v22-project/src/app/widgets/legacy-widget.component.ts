import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { DataService } from './data.service';
import { LogService } from './log.service';
import { ConfigService } from './config.service';

@Component({
  selector: 'app-legacy-widget',
  template: '<div>{{ title }}</div>',
  standalone: false,
})
export class LegacyWidgetComponent implements OnInit, OnDestroy {
  @Input() title = '';
  @Input() subtitle = '';
  @Output() changed = new EventEmitter<string>();

  private destroy$ = new Subject<void>();

  constructor(
    private data: DataService,
    private log: LogService,
    private config: ConfigService,
  ) {}

  ngOnInit(): void {
    this.data.load().subscribe((r) => this.handle(r));
    this.config.watch().subscribe();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
  }

  handle(r: unknown): void {
    this.log.write(r);
  }

  refresh(): void {}
}
