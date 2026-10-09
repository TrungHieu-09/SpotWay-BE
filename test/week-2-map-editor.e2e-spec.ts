import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { ResponseInterceptor } from '../src/common/response.interceptor';

const runE2E = Boolean(process.env.TEST_DATABASE_URL);
const describeE2E = runE2E ? describe : describe.skip;

describeE2E('Week 2 Map Editor (e2e)', () => {
  let app: INestApplication;
  let token: string;
  let buildingId: string;
  let floorOneId: string;
  let floorTwoId: string;
  let elevatorOneId: string;
  let elevatorTwoId: string;
  let normalNodeId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'admin@spotway.local', password: 'ChangeMe123!' }).expect(201);
    token = login.body.data.accessToken;
    const buildings = await request(app.getHttpServer()).get('/api/v1/buildings?page=1&limit=1').set('Authorization', `Bearer ${token}`).expect(200);
    const tenantId = buildings.body.data.items[0].tenantId;
    const suffix = Date.now();
    const building = await request(app.getHttpServer()).post('/api/v1/buildings').set('Authorization', `Bearer ${token}`).send({ name: `E2E Building ${suffix}`, tenantId }).expect(201);
    buildingId = building.body.data.id;
  }, 30000);

  afterAll(async () => {
    if (app && buildingId) await request(app.getHttpServer()).delete(`/api/v1/buildings/${buildingId}`).set('Authorization', `Bearer ${token}`);
    await app?.close();
  });

  it('creates, validates, and soft-deletes a complete map graph', async () => {
    const floorOne = await request(app.getHttpServer()).post(`/api/v1/buildings/${buildingId}/floors`).set('Authorization', `Bearer ${token}`).send({ floorNumber: 1, name: 'E2E Floor 1', mapWidth: 500, mapHeight: 300 }).expect(201);
    floorOneId = floorOne.body.data.id;
    const floorTwo = await request(app.getHttpServer()).post(`/api/v1/buildings/${buildingId}/floors`).set('Authorization', `Bearer ${token}`).send({ floorNumber: 2, name: 'E2E Floor 2', mapWidth: 500, mapHeight: 300 }).expect(201);
    floorTwoId = floorTwo.body.data.id;

    await request(app.getHttpServer()).post(`/api/v1/floors/${floorOneId}/nodes`).set('Authorization', `Bearer ${token}`).send({ x: 501, y: 10, type: 'NORMAL' }).expect(400);
    const elevatorOne = await request(app.getHttpServer()).post(`/api/v1/floors/${floorOneId}/nodes`).set('Authorization', `Bearer ${token}`).send({ x: 100, y: 100, type: 'ELEVATOR' }).expect(201);
    elevatorOneId = elevatorOne.body.data.id;
    const normal = await request(app.getHttpServer()).post(`/api/v1/floors/${floorOneId}/nodes`).set('Authorization', `Bearer ${token}`).send({ x: 200, y: 100, type: 'NORMAL' }).expect(201);
    normalNodeId = normal.body.data.id;
    const elevatorTwo = await request(app.getHttpServer()).post(`/api/v1/floors/${floorTwoId}/nodes`).set('Authorization', `Bearer ${token}`).send({ x: 100, y: 100, type: 'ELEVATOR' }).expect(201);
    elevatorTwoId = elevatorTwo.body.data.id;

    await request(app.getHttpServer()).post(`/api/v1/floors/${floorOneId}/edges`).set('Authorization', `Bearer ${token}`).send({ fromNodeId: elevatorOneId, toNodeId: normalNodeId }).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/floors/${floorOneId}/edges`).set('Authorization', `Bearer ${token}`).send({ fromNodeId: normalNodeId, toNodeId: elevatorOneId }).expect(409);
    await request(app.getHttpServer()).post(`/api/v1/floors/${floorOneId}/pois`).set('Authorization', `Bearer ${token}`).send({ nodeId: normalNodeId, name: 'E2E information', category: 'INFO' }).expect(201);

    await request(app.getHttpServer()).post(`/api/v1/floors/${floorOneId}/publish`).set('Authorization', `Bearer ${token}`).expect(400);
    await request(app.getHttpServer()).post(`/api/v1/buildings/${buildingId}/elevator-links`).set('Authorization', `Bearer ${token}`).send({ nodeIdFrom: elevatorOneId, nodeIdTo: elevatorTwoId }).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/floors/${floorOneId}/publish`).set('Authorization', `Bearer ${token}`).expect(201);

    await request(app.getHttpServer()).delete(`/api/v1/floors/${floorOneId}`).set('Authorization', `Bearer ${token}`).expect(200);
    await request(app.getHttpServer()).get(`/api/v1/nodes/${normalNodeId}`).set('Authorization', `Bearer ${token}`).expect(404);
  }, 30000);
});
