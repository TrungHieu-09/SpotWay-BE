/** Binary min-heap: push and pop are O(log n), peek is O(1). Equal priorities pop in insertion order, so results are deterministic. */
export class MinHeap<T> {
  private readonly items: Array<{ priority: number; order: number; value: T }> = [];
  private counter = 0;

  get size() { return this.items.length; }

  push(value: T, priority: number) {
    this.items.push({ priority, order: this.counter++, value });
    this.siftUp(this.items.length - 1);
  }

  peek(): T | undefined { return this.items[0]?.value; }

  pop(): { value: T; priority: number } | undefined {
    const top = this.items[0];
    if (!top) return undefined;
    const last = this.items.pop()!;
    if (this.items.length) { this.items[0] = last; this.siftDown(0); }
    return { value: top.value, priority: top.priority };
  }

  private before(a: number, b: number) {
    const x = this.items[a];
    const y = this.items[b];
    return x.priority < y.priority || (x.priority === y.priority && x.order < y.order);
  }

  private swap(a: number, b: number) { [this.items[a], this.items[b]] = [this.items[b], this.items[a]]; }

  private siftUp(index: number) {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.before(index, parent)) return;
      this.swap(index, parent);
      index = parent;
    }
  }

  private siftDown(index: number) {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.items.length && this.before(left, smallest)) smallest = left;
      if (right < this.items.length && this.before(right, smallest)) smallest = right;
      if (smallest === index) return;
      this.swap(index, smallest);
      index = smallest;
    }
  }
}
