import { Component, ChangeDetectionStrategy, inject, input, output, signal, computed } from '@angular/core';
import { OrderService } from './order.service';
import { AuthService } from '../shared/auth.service';

@Component({
  selector: 'app-order-list',
  templateUrl: './order-list.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrderListComponent {
  private readonly orders = inject(OrderService);
  private readonly auth = inject(AuthService);

  readonly customerId = input.required<string>();
  readonly pageSize = input<number>(20);
  readonly selected = output<string>();

  private readonly query = signal('');
  readonly visible = computed(() => this.query());

  select(id: string): void {
    this.selected.emit(id);
  }

  private internalHelper(): void {
    this.auth.touch();
  }
}
