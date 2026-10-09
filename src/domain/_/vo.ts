export abstract class ValueObject<Properties> {
  private readonly _props: Properties | null;

  constructor(props: unknown) {
    this._props = this.validate(props) ? this.format(props) : null;
    Object.freeze(this);
  }

  protected format(props: Properties) {
    return props;
  }

  isInvalid() {
    return this._props === null;
  }

  isValid() {
    return !this.isInvalid();
  }

  get props() {
    if (this._props !== null) return this._props;
    throw new Error();
  }

  protected abstract validate(props: unknown): props is Properties;

  get value() {
    return this.props;
  }
}
