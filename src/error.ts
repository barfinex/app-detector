export enum ErrorEnvironment {
    Unknown,
    Genetic,
    History,
    Core,
    Provider,
    Detector,
    Inspector,
    Tester,
}

export class Error {
    public message: string;

    constructor(public env: ErrorEnvironment, msg: string) {
        this.message = `${this.getErrorMessage()}  ${msg}`;
    }

    private getErrorMessage() {
        switch (this.env) {
            case ErrorEnvironment.History:
                return 'History error:';
            case ErrorEnvironment.Core:
                return 'Core error:';
            case ErrorEnvironment.Genetic:
                return 'Genetic error:';
            case ErrorEnvironment.Tester:
                return 'Tester error:';
            case ErrorEnvironment.Provider:
                return 'Provider error:';
            case ErrorEnvironment.Detector:
                return 'Detector error:';
            case ErrorEnvironment.Inspector:
                return 'Inspector error:';
            default:
                return 'Unknown error:';
        }
    }

    toString() {
        return this.message;
    }
}