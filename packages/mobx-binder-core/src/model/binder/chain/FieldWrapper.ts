import { KnownData, Modifier, ValidValueValidationResult } from './Modifier'
import { Context } from '../Context'
import { FieldStore } from '../../fields/FieldStore'
import { Validity } from '../../../validation/Validity'
import { ModifierState } from './ModifierState'

export class FieldWrapper<ValidationResult, ValueType> implements Modifier<ValidationResult, ValueType, ValueType> {
    constructor(public field: FieldStore<ValueType>, private context: Context<ValidationResult>) {}

    get type() {
        return `field<${this.field.valueType}>`
    }

    get data(): KnownData<ValueType> {
        return {
            value: this.field.value,
            pending: false,
        }
    }

    get required() {
        return false
    }

    get validity(): Validity<ValidationResult> {
        return {
            status: 'validated',
            result: this.context.validResult,
        }
    }

    public get bindingState(): Array<ModifierState<ValidationResult>> {
        const { type, data, required, validity } = this
        return [
            {
                name: this.field.name,
                type,
                data,
                required,
                validity,
                more: this.field.debugState,
            },
        ]
    }

    public toView(modelValue: any) {
        return modelValue
    }

    public validateValue(fieldValue: ValueType): ValidValueValidationResult<ValueType> {
        return {
            valid: true,
            value: fieldValue,
        }
    }

    public validateAsync(): Promise<Validity<ValidationResult>> {
        return Promise.resolve(this.validity)
    }

    public applyConversionsToField(): void {
        // nothing to apply
    }

    public isEqual(first: ValueType, second: ValueType): boolean {
        return first === second
    }
}
