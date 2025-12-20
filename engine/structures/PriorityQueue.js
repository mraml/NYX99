/**
 * PriorityQueue.js
 * A generic binary heap implementation for O(log n) inserts and O(1) peek.
 * Default behavior is a Min-Heap (lowest value pops first), but we use a custom comparator
 * to make it a Max-Heap for scores (highest score pops first).
 */
export class PriorityQueue {
    constructor(comparator = (a, b) => a - b) {
      this._heap = [];
      this._comparator = comparator;
    }
  
    size() {
      return this._heap.length;
    }
  
    isEmpty() {
      return this.size() === 0;
    }
  
    peek() {
      return this._heap[0];
    }
  
    // Supports pushing single items or arrays to match legacy array.push API roughly
    push(...values) {
      values.forEach(value => {
        this._heap.push(value);
        this._siftUp();
      });
      return this.size();
    }
  
    pop() {
      const poppedValue = this.peek();
      const bottom = this.size() - 1;
      if (bottom > 0) {
        this._swap(0, bottom);
      }
      this._heap.pop();
      this._siftDown();
      return poppedValue;
    }
  
    _parent(idx) { return Math.floor((idx - 1) / 2); }
    _left(idx) { return idx * 2 + 1; }
    _right(idx) { return idx * 2 + 2; }
  
    _swap(i, j) {
      [this._heap[i], this._heap[j]] = [this._heap[j], this._heap[i]];
    }
  
    _compare(i, j) {
      return this._comparator(this._heap[i], this._heap[j]);
    }
  
    _siftUp() {
      let node = this.size() - 1;
      while (node > 0 && this._compare(node, this._parent(node)) < 0) {
        this._swap(node, this._parent(node));
        node = this._parent(node);
      }
    }
  
    _siftDown() {
      let node = 0;
      while (
        (this._left(node) < this.size() && this._compare(this._left(node), node) < 0) ||
        (this._right(node) < this.size() && this._compare(this._right(node), node) < 0)
      ) {
        let maxChild = (this._right(node) < this.size() && this._compare(this._right(node), this._left(node)) < 0) 
            ? this._right(node) 
            : this._left(node);
        this._swap(node, maxChild);
        node = maxChild;
      }
    }
    
    // Helper to convert to array for logging/debugging
    toArray() {
        return [...this._heap].sort(this._comparator);
    }
  }