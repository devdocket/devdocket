import { createLoggerService } from '@workcenter/shared';

export { LogLevel, resolveLogLevel, serializeArg } from '@workcenter/shared';

const service = createLoggerService();

export const logger = service.logger;
export const initLogger = service.initLogger;
export const setLogLevel = service.setLogLevel;
