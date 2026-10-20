/**
 * First-in-first-out queue with O(1) amortised push and take. `array.splice(0, n)` shifts every remaining element,
 * which turns draining a deep queue into quadratic work (it froze the page during bursts).
 */
export class FifoQueue<T> {
    private items: T[] = []
    private head = 0

    get length(): number {
        return this.items.length - this.head
    }

    push(item: T): void {
        this.items.push(item)
    }

    /** Removes and returns the oldest item, or undefined when empty. */
    shift(): T | undefined {
        if (this.head >= this.items.length) return undefined
        const item = this.items[this.head]
        this.release(this.head + 1)
        return item
    }

    /** Removes and returns up to `n` items from the front, oldest first. */
    take(n: number): T[] {
        const end = Math.min(this.items.length, this.head + n)
        const out = this.items.slice(this.head, end)
        this.release(end)
        return out
    }

    /** Drops up to `n` items from the front without copying them. Returns how many were dropped. */
    dropOldest(n: number): number {
        const end = Math.min(this.items.length, this.head + n)
        const dropped = end - this.head
        this.release(end)
        return dropped
    }

    clear(): void {
        this.items = []
        this.head = 0
    }

    private release(newHead: number): void {
        // Clear the slots so removed items can be collected, and compact once the dead prefix is large.
        for (let i = this.head; i < newHead; i++) this.items[i] = undefined as T
        this.head = newHead
        if (this.head === this.items.length) this.clear()
        else if (this.head > 4096 && this.head * 2 > this.items.length) {
            this.items = this.items.slice(this.head)
            this.head = 0
        }
    }
}
