import { action, makeObservable, observable } from 'mobx'
import { FieldStore } from './FieldStore'
import { Binding } from '../binder/Binder'
import sleep from '../../utils/sleep'

export abstract class AbstractField<ValueType> implements FieldStore<ValueType> {
    public readOnly = false

    public showValidationResults = false

    public abstract value: ValueType

    public touched = false

    public visited = false

    private binding?: Binding<unknown, unknown> = undefined

    protected constructor(public readonly valueType: string, public readonly name: string) {
        makeObservable(this, {
            showValidationResults: observable,
            touched: observable,
            visited: observable,
            updateValue: action.bound,
            handleFocus: action.bound,
            handleBlur: action.bound,
            reset: action.bound,
        })
    }

    get valid() {
        this.assertBound(this.binding)
        return this.binding.valid
    }

    get required() {
        this.assertBound(this.binding)
        return this.binding.required
    }

    get validating() {
        this.assertBound(this.binding)
        return this.binding.validating
    }

    get errorMessage() {
        this.assertBound(this.binding)
        return this.binding.errorMessage
    }

    set errorMessage(customErrorMessage: string | undefined) {
        this.assertBound(this.binding)
        this.binding.customErrorMessage = customErrorMessage
    }

    get changed() {
        this.assertBound(this.binding)
        return this.binding.changed
    }

    public bind(binding: Binding<unknown, unknown>) {
        this.binding = binding
    }

    public updateValue(newValue: ValueType) {
        this.value = newValue
        this.touched = true
    }

    public handleFocus(): void {
        this.visited = true
    }

    public handleBlur(): void {
        void Promise.all([sleep(100), this.binding?.validateOnBlur()]).then(
            action(() => {
                this.showValidationResults = true
            }),
        )
    }

    public reset(value: ValueType) {
        this.assertBound(this.binding)
        this.value = value
        this.binding.setUnchanged()
        this.binding.customErrorMessage = undefined
        this.touched = false
        this.visited = false
        this.showValidationResults = false
    }

    private assertBound(binding?: Binding<unknown, unknown>): asserts binding {
        if (!binding) {
            throw new Error('Trying to use an unbound field')
        }
    }
}
