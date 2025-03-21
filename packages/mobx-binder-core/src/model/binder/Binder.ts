import { Converter, AsyncConverter } from '../../conversion/Converter'
import { action, computed, isObservable, makeObservable, observable, reaction, runInAction, toJS } from 'mobx'
import { EmptyStringConverter } from '../../conversion/EmptyStringConverter'
import { FieldStore } from '../fields/FieldStore'
import { Modifier } from './chain/Modifier'
import { FieldWrapper } from './chain/FieldWrapper'
import { ConvertingModifier } from './chain/ConvertingModifier'
import { ValidatingModifier } from './chain/ValidatingModifier'
import { AsyncValidatingModifier } from './chain/AsyncValidatingModifier'
import { ChangeEventHandler } from './chain/ChangeEventHandler'
import { Context } from './Context'
import { AsyncValidator, Validator } from '../../validation/Validator'
import isEqual from 'lodash.isequal'
import { isPromise } from '../../utils/isPromise'
import { AsyncConvertingModifier } from './chain/AsyncConvertingModifier'
import { Validity } from '../../validation/Validity'
import { wrapRequiredValidator } from '../../validation/WrappedValidator'
import { ModifierState } from './chain/ModifierState'

/**
 * API for single field binding
 */
export interface Binding<FieldType, ValidationResult> {
    readonly changed: boolean
    readonly required: boolean
    readonly validating: boolean
    readonly errorMessage?: string
    readonly valid?: boolean
    readonly field: FieldStore<FieldType>
    customErrorMessage?: string

    /**
     * The validation status of the current binding.
     */
    readonly validity: Validity<ValidationResult>

    /**
     * The state of the field and all modifications that happen in the validation/conversion chain for debugging purposes.
     */
    readonly state: Array<ModifierState<ValidationResult>>

    /**
     * Load the field value from the source object, treating it as "unchanged" value.
     *
     * @param source
     */
    load(source: any): void

    /**
     * Update the field value from the source object, treating it as a change.
     *
     * @param source
     */
    apply(source: any): void

    /**
     * Return the view representation of the field value from the source object.
     *
     * @param source
     */
    getFieldValue(source: any): FieldType

    /**
     * Store the valid field value to the target object
     *
     * @param target
     */
    store(target: any): void

    /**
     * Trigger asynchronous validation. onBlur indicates the current event - the binding then decides if a validation takes place or not.
     *
     * @param onBlur
     */
    validateAsync(onBlur?: boolean): Promise<string | undefined>

    /**
     * Validate a given field value against the configured validations and conversions. If there are async operations, it returns a promise.
     *
     * @param fieldValue
     */
    validateValue(fieldValue: FieldType): string | undefined | Promise<string | undefined>

    /**
     * Sets the current field value to be handled as not changed.
     */
    setUnchanged(): void

    /**
     * Called on blur before showing validation errors.
     */
    validateOnBlur(): Promise<void>
}

class StandardBinding<FieldType, ValidationResult> implements Binding<FieldType, ValidationResult> {
    public customErrorMessage?: string

    private unchangedValue?: any

    constructor(
        private readonly context: Context<ValidationResult>,
        public readonly field: FieldStore<any>,
        private readonly chain: Modifier<ValidationResult, any, any>,
        private read: (source: any) => any,
        private write?: (target: any, value: any) => void,
    ) {
        this.setUnchanged()
        this.observeField()
        makeObservable<StandardBinding<FieldType, ValidationResult>, 'unchangedValue' | 'customErrorMessage' | 'applyConversionsToField'>(this, {
            unchangedValue: observable.ref,
            customErrorMessage: observable,

            changed: computed,
            validating: computed,
            model: computed,
            required: computed,
            validity: computed,
            valid: computed,
            errorMessage: computed,

            setUnchanged: action.bound,
            validateAsync: action.bound,
            load: action.bound,
            apply: action.bound,
            applyConversionsToField: action.bound,
            validateOnBlur: action.bound,
        })
    }

    public get changed() {
        const currentValue = isObservable(this.field.value) ? toJS(this.field.value) : this.field.value

        return !isEqual(currentValue, this.unchangedValue)
    }

    get validating() {
        return this.validity.status === 'validating'
    }

    get model() {
        return this.chain.data
    }

    get required() {
        return this.chain.required
    }

    get validity(): Validity<ValidationResult> {
        return this.chain.validity
    }

    public get valid(): boolean | undefined {
        if (this.customErrorMessage) {
            return false
        }
        return this.validity.status === 'validated' ? this.context.valid(this.validity.result) : undefined
    }

    get errorMessage() {
        if (this.customErrorMessage) {
            return this.customErrorMessage
        }
        return this.validity.status === 'validated' && !this.context.valid(this.validity.result) ? this.context.translate(this.validity.result) : undefined
    }

    public get state() {
        return this.chain.bindingState
    }

    public setUnchanged() {
        const fieldValue = this.field.value
        this.unchangedValue = isObservable(fieldValue) ? toJS(fieldValue) : fieldValue
    }

    public validateValue(fieldValue: FieldType): string | undefined | Promise<string | undefined> {
        const someResult = this.chain.validateValue(fieldValue)
        if (isPromise(someResult)) {
            return someResult.then(data => this.toErrorMessage(data.valid ? this.context.validResult : data.result))
        }
        return this.toErrorMessage(someResult.valid ? this.context.validResult : someResult.result)
    }

    public validateAsync(onBlur = false): Promise<string | undefined> {
        return this.chain.validateAsync(onBlur).then(
            action(() => {
                const validity = this.validity
                const validationResult = validity.status === 'validated' ? validity.result : this.context.validResult
                this.correctFieldValue()
                return this.toErrorMessage(validationResult)
            }),
        )
    }

    public load(source: any): void {
        const fieldValue = this.getFieldValue(source)
        this.field.reset(fieldValue)
        this.setUnchanged()
    }

    public apply(source: any): void {
        const fieldValue = this.getFieldValue(source)
        this.field.updateValue(fieldValue)
    }

    public getFieldValue(source: any): FieldType {
        const value = this.read(source)
        return this.chain.toView(value)
    }

    public store(target: any) {
        if (this.write) {
            if (this.valid && !this.model.pending) {
                this.write(target, this.model.value)
            }
        }
    }

    public async validateOnBlur(): Promise<void> {
        await this.validateAsync(true)
        this.applyConversionsToField()
    }

    private correctFieldValue() {
        if (this.valid && !this.chain.data.pending) {
            const fieldValue = this.chain.toView(this.chain.data.value)
            this.field.updateValue(fieldValue)
        }
    }

    private toErrorMessage(validationResult: ValidationResult) {
        return this.context.valid(validationResult) ? undefined : this.context.translate(validationResult)
    }

    private applyConversionsToField() {
        this.chain.applyConversionsToField()
    }

    private observeField() {
        this.clearCustomErrorMessageOnValueChange()
        this.field.bind(this)
    }

    private clearCustomErrorMessageOnValueChange() {
        reaction(
            () => this.field.value,
            () => {
                this.customErrorMessage = undefined
            },
        )
    }
}

export class BindingBuilder<ValidationResult, ValueType, BinderType extends Binder<ValidationResult>> {
    private readOnly = false
    private last: Modifier<ValidationResult, any, any>

    constructor(
        private readonly binder: BinderType,
        private readonly addBinding: (binding: StandardBinding<any, ValidationResult>) => void,
        private readonly field: FieldStore<ValueType>,
    ) {
        this.last = new FieldWrapper(field, binder.context)

        makeObservable(this, {
            withAsyncConverter: action,
            withAsyncValidator: action,
            bind2: action,
        })
    }

    /**
     * Adds a converter that converts empty strings to the given value and vice versa.
     */
    public withEmptyString<X = undefined>(to: X): BindingBuilder<ValidationResult, string | X, BinderType> {
        if (this.field.valueType === 'string') {
            return (this as BindingBuilder<ValidationResult, unknown, BinderType>).withConverter(new EmptyStringConverter<X>(to))
        }
        throw new Error('This is not a field of type string')
    }

    /**
     * Adds a converter that converts empty strings to `undefined` and vice versa.
     */
    public withStringOrUndefined(): BindingBuilder<ValidationResult, string | undefined, BinderType> {
        return this.withEmptyString(undefined)
    }

    /**
     * Add a Converter to the binding chain. Validations added after a conversion have to match with the converted type.
     *
     * @param converter
     */
    public withConverter<NextType>(converter: Converter<ValidationResult, ValueType, NextType>): BindingBuilder<ValidationResult, NextType, BinderType> {
        return this.addModifier<NextType>(new ConvertingModifier(this.last, this.binder.context, converter))
    }

    /**
     * Add an asynchronous validator to the binding chain. Async validations happen on submit and - if configured via the options parameter - also on blur.
     * @param asyncConverter
     * @param options
     */
    public withAsyncConverter<NextType>(
        asyncConverter: AsyncConverter<ValidationResult, ValueType, NextType>,
        options: { onBlur: boolean } = { onBlur: false },
    ): BindingBuilder<ValidationResult, NextType, BinderType> {
        return this.addModifier<NextType>(new AsyncConvertingModifier(this.last, this.binder.context, asyncConverter, options))
    }

    /**
     * Add a synchronous Validator to the binding chain. Sync validations happen on every value update.
     * @param validator
     */
    public withValidator(validator: Validator<ValidationResult, ValueType>): BindingBuilder<ValidationResult, ValueType, BinderType> {
        return this.addModifier<ValueType>(new ValidatingModifier(this.last, this.binder.context, validator))
    }

    /**
     * Add an asynchronous validator to the binding chain. Async validations happen on submit and - if configured via the options parameter - also on blur.
     * @param asyncValidator
     * @param options
     */
    public withAsyncValidator(
        asyncValidator: AsyncValidator<ValidationResult, ValueType>,
        options: { onBlur: boolean } = { onBlur: false },
    ): BindingBuilder<ValidationResult, ValueType, BinderType> {
        return this.addModifier<ValueType>(new AsyncValidatingModifier(this.last, this.binder.context, asyncValidator, options))
    }

    /**
     * Mark the field as read-only.
     */
    public isReadOnly(): BindingBuilder<ValidationResult, ValueType, BinderType> {
        this.readOnly = true
        return this
    }

    /**
     * Add a "required" validator and mark the field as required.
     *
     * @param messageKey
     * @param condition the validation will only be applied if this method returns true.
     *      Also the `required` FieldStore property will be dynamically set based on this.
     */
    public isRequired(messageKey?: string, condition: () => boolean = () => true): BindingBuilder<ValidationResult, ValueType, BinderType> {
        return this.withValidator(wrapRequiredValidator(this.binder.context.requiredValidator(messageKey), condition))
    }

    /**
     * Add a value change event handler to the chain - it's only called if previous validations succeed.
     * @param onChange
     */
    public onChange(onChange: (value: ValueType) => any): BindingBuilder<ValidationResult, ValueType, BinderType> {
        return this.addModifier(new ChangeEventHandler(this.last, this.binder.context, onChange))
    }

    /**
     * Finally bind/map the field to a backend object via a simple property named like the field name.
     * @param name
     */
    public bind(name?: string): BinderType {
        const propertyName = name || this.field.name

        return this.bind2(
            (source: any) => source[propertyName],
            (target: any, value?: ValueType) => (target[propertyName] = value),
        )
    }

    /**
     * Finally bind the field to a backend object, using the given read/write functions for loading and storing. If the write method is omitted, the field is
     * marked as read-only.
     *
     * @param read
     * @param write
     */
    public bind2<T>(read: (source: T) => ValueType | undefined, write?: (target: T, value?: ValueType) => void): BinderType {
        this.field.readOnly = this.readOnly || !write

        this.addBinding(new StandardBinding(this.binder.context, this.field, this.last, read, this.readOnly ? undefined : write))
        return this.binder
    }

    private addModifier<NextType>(modifier: Modifier<ValidationResult, ValueType, NextType>): BindingBuilder<ValidationResult, NextType, BinderType> {
        this.last = modifier
        return this as any
    }
}

export class Binder<ValidationResult> {
    /**
     * Indicates if a #submit() operation is currently in progress. This covers async validations happening on submit and also the `onSuccess` operation.
     */
    public submitting?: boolean

    private _bindings: Array<StandardBinding<unknown, ValidationResult>> = observable([])

    constructor(public readonly context: Context<ValidationResult>) {
        makeObservable<Binder<ValidationResult>, 'addBinding'>(this, {
            submitting: observable,

            valid: computed,
            validating: computed,
            changed: computed,
            changedData: computed,

            removeBinding: action,
            load: action,
            apply: action,
            setUnchanged: action.bound,
            submit: action.bound,
            showValidationResults: action.bound,
            validateAsync: action.bound,
            addBinding: action,
        })
        runInAction(() => {
            this.submitting = false
        })
    }

    get bindings(): ReadonlyArray<StandardBinding<unknown, ValidationResult>> {
        return this._bindings
    }

    /**
     * The global form validation status.
     * - `true`: all async validations are done and all fields are valid
     * - `false`: any sync or async validation failed
     * - `undefined`: all sync validations are successful, async validations are not yet performed
     */
    get valid(): boolean | undefined {
        const validities = this.bindings.map(binding => binding.valid)
        if (validities.every((validity: boolean | undefined) => validity === true)) {
            return true
        } else if (validities.some((validity: boolean | undefined) => validity === false)) {
            return false
        }
        return undefined
    }

    /**
     * Indicates whether any async validation is currently in progress.
     */
    get validating(): boolean {
        return this.bindings.map(binding => binding.validating).every(validating => validating)
    }

    /**
     * Indicates if any field has a changed value.
     */
    get changed(): boolean {
        return this.bindings.map(binding => binding.changed).some(changed => changed)
    }

    get changedData(): any {
        return this.bindings
            .filter(binding => binding.changed && binding.valid === true)
            .reduce((data: any, binding: Binding<any, ValidationResult>) => {
                binding.store(data)
                return data
            }, {})
    }

    /**
     * `BindingBuilder` creation for adding a new field binding.
     *
     * @param field
     */
    public forField<ValueType>(field: FieldStore<ValueType>): BindingBuilder<ValidationResult, ValueType, Binder<ValidationResult>> {
        return new BindingBuilder(this, this.addBinding.bind(this), field)
    }

    /**
     * Shortcut for `forField(someField).withStringOrUndefined()`
     *
     * @param field
     */
    public forStringField(field: FieldStore<string>): BindingBuilder<ValidationResult, string | undefined, Binder<ValidationResult>> {
        return this.forField(field).withStringOrUndefined()
    }

    /**
     * Here you can remove existing bindings. This re-evaluates the global form validation status.
     * This way you can conditionally add/remove "hidden" fields that are only visible under certain conditions.
     *
     * @param field
     */
    public removeBinding(field: FieldStore<unknown>): void {
        const index = this.bindings.findIndex(binding => binding.field === field)
        this._bindings.splice(index, 1)
    }

    /**
     * Provides access to a single field `Binding`.
     * @param field
     */
    public binding<FieldType>(field: FieldStore<FieldType>): Binding<FieldType, ValidationResult> {
        const result = this.bindings.find(binding => binding.field === field)

        if (!result) {
            throw new Error(`Cannot find binding for ${field.name}`)
        }
        return result as StandardBinding<FieldType, ValidationResult>
    }

    /**
     * Same as `load({})`
     */
    public clear(): void {
        this.load({})
    }

    /**
     * Loads the values from the given backend object, treating them as "unchanged" values.
     *
     * @param source
     */
    public load(source: any): void {
        this.bindings.forEach(binding => {
            binding.load(source)
        })
    }

    /**
     * Update all field values from the given backend object, treating them as changed.
     *
     * @param source
     */
    public apply(source: any): void {
        this.bindings.forEach(binding => {
            binding.apply(source)
        })
    }

    /**
     * Stores converted valid field values to to the given backend object.
     *
     * @param target
     */
    public store<TargetType = any>(target: TargetType = {} as any): TargetType {
        this.bindings.forEach(binding => {
            binding.store(target)
        })
        return target
    }

    /**
     * Sets all fields with current values to be not changed.
     */
    public setUnchanged(): void {
        this.bindings.forEach(binding => {
            binding.setUnchanged()
        })
    }

    /**
     * Actively trigger async validation / wait for still ongoing validations.
     * Please note that async validation results for a value might be cached.
     * If any validation fails, it rejects with an error.
     */
    public async validateAsync(): Promise<void> {
        await Promise.all(this.bindings.map(binding => binding.validateAsync())).then(results => {
            if (results.some(result => !!result)) {
                throw new Error()
            }
        })
    }

    /**
     * "Submit" the form. Performs an async validation and if successful,
     * executes the `onSuccess` callback with the field values stored into the `target` object.
     * During validation/onSuccess, the `submitting` property is set to true.
     * If validation failed, `showValidationResults()` is called and the function rejects with an "empty" Error (without a message).
     * In case of another error, like `onSubmit()` rejection, the error is propagated as is.
     *
     * @param target
     * @param onSuccess
     */
    public submit<TargetType = any>(
        target: Partial<TargetType> = {},
        onSuccess?: (target: TargetType) => Promise<TargetType> | void | undefined,
    ): Promise<TargetType> {
        let promise: Promise<any> = Promise.resolve()
        this.submitting = true
        if (this.valid !== false) {
            promise = promise
                .then(() => this.validateAsync())
                .catch(err => {
                    this.showValidationResults()
                    throw err
                })
                .then(
                    action(() => {
                        const result = this.store(target)
                        if (onSuccess) {
                            const newPromise = onSuccess(result as TargetType)

                            if (newPromise?.then) {
                                return newPromise.then(() => result)
                            }
                        }
                        return result
                    }),
                )
        } else {
            this.showValidationResults()
            const error = new Error() // message empty as it's no global/submission error
            promise = Promise.reject(error)
        }
        return promise.then(
            action((x: any) => {
                this.submitting = false
                return x
            }),
            action((err: any) => {
                this.submitting = false
                throw err
            }),
        )
    }

    /**
     * Shows validation results on all fields.
     */
    public showValidationResults(): void {
        this.bindings.forEach(binding => {
            binding.field.showValidationResults = true
        })
    }

    /**
     * Used by the `BindingBuilder` after preparing a new field.
     * @param binding
     */
    private addBinding(binding: StandardBinding<any, ValidationResult>) {
        this._bindings.push(binding)
    }
}
