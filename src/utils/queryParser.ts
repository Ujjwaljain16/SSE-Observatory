import { EventMessage } from '../types'
import { getFieldValue } from './eventUtils'

type Operator = '==' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'matches'
type LogicalOperator = 'AND' | 'OR'

interface QueryNode {
    type: 'comparison' | 'logical'
    operator?: Operator | LogicalOperator
    left?: string | QueryNode
    right?: any | QueryNode
}

export class QueryParser {
    private tokens: string[]
    private position: number

    constructor(query: string) {
        this.tokens = this.tokenize(query)
        this.position = 0
    }

    private tokenize(query: string): string[] {
        // Regex to match tokens: strings, numbers, operators, parentheses, keywords
        // NOTE: `=>` is intentionally excluded — it is not a valid DSL operator
        const regex = /\s*(<=|==|!=|[><()]|AND|OR|contains|matches|"[^"]*"|'[^']*'|[\w.]+)\s*/g
        return query.match(regex)?.map(t => t.trim()).filter(t => t) || []
    }

    private peek(): string {
        return this.tokens[this.position]
    }

    private consume(): string {
        return this.tokens[this.position++]
    }

    public parse(): QueryNode {
        const node = this.parseExpression()
        if (this.position < this.tokens.length) {
            throw new Error(`Unexpected token at end: ${this.peek()}`)
        }
        return node
    }

    private parseExpression(): QueryNode {
        let left = this.parseTerm()

        while (this.peek() === 'OR') {
            const operator = this.consume() as LogicalOperator
            const right = this.parseTerm()
            left = { type: 'logical', operator, left, right }
        }

        return left
    }

    private parseTerm(): QueryNode {
        let left = this.parseFactor()

        while (this.peek() === 'AND') {
            const operator = this.consume() as LogicalOperator
            const right = this.parseFactor()
            left = { type: 'logical', operator, left, right }
        }

        return left
    }

    private parseFactor(): QueryNode {
        if (this.peek() === '(') {
            this.consume() // eat (
            const node = this.parseExpression()
            if (this.consume() !== ')') {
                throw new Error("Missing closing parenthesis")
            }
            return node
        }

        return this.parseComparison()
    }

    private parseComparison(): QueryNode {
        const field = this.consume()
        const operator = this.consume() as Operator
        let value: any = this.consume()

        // Remove quotes from strings
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        } else if (!isNaN(Number(value))) {
            value = Number(value)
        }

        return { type: 'comparison', operator, left: field, right: value }
    }

    public compile(node: QueryNode): (event: EventMessage) => boolean {
        if (node.type === 'logical') {
            const leftFn = this.compile(node.left as QueryNode)
            const rightFn = this.compile(node.right as QueryNode)
            return (event) => {
                if (node.operator === 'AND') return leftFn(event) && rightFn(event)
                if (node.operator === 'OR') return leftFn(event) || rightFn(event)
                return false
            }
        }

        // For `matches`, compile the RegExp once here in the closure — not per event
        const matchesRegex = node.operator === 'matches'
            ? (() => {
                try { return new RegExp(node.right, 'i') }
                catch { return null }
            })()
            : null

        return (event) => {
            const fieldPath = node.left as string
            const fieldValue = getFieldValue(event, fieldPath)
            const targetValue = node.right

            switch (node.operator) {
                // eslint-disable-next-line eqeqeq -- loose equality is the DSL's documented string/number semantics
                case '==': return fieldValue == targetValue
                // eslint-disable-next-line eqeqeq
                case '!=': return fieldValue != targetValue
                case '>': return Number(fieldValue) > Number(targetValue)
                case '<': return Number(fieldValue) < Number(targetValue)
                case '>=': return Number(fieldValue) >= Number(targetValue)
                case '<=': return Number(fieldValue) <= Number(targetValue)
                case 'contains': return String(fieldValue).toLowerCase().includes(String(targetValue).toLowerCase())
                case 'matches': return matchesRegex !== null && matchesRegex.test(String(fieldValue))
                default: return false
            }
        }
    }
}
