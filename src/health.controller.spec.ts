import { HealthController } from './health.controller';
describe('HealthController', () => {
  it('returns an OK status', () => {
    expect(new HealthController().check()).toEqual({ status: 'ok' });
  });
});
