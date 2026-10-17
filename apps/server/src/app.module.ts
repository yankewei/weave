import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { HealthController } from './health.controller.js';
import { Database } from './database.js';
import {
  AuthController,
  AuthService,
  RequestGuard,
  SessionGuard,
} from './auth.js';
import { DocumentsController, DocumentsService } from './documents.js';
import { TasksController, TasksService } from './tasks.js';
import {
  TaskCommentsController,
  TaskCommentsService,
} from './task-comments.js';
import { MembersController, MembersService } from './members.js';
import {
  WorkspaceStorageController,
  WorkspaceStorageService,
} from './workspace-storage.js';
import {
  ConversationsController,
  ConversationsService,
} from './conversations.js';
import { CommandCodeTaskProposalModel } from './task-proposal-model.js';
import { StorageSecretBox } from './storage-secret.js';

@Module({
  controllers: [
    HealthController,
    AuthController,
    DocumentsController,
    TasksController,
    TaskCommentsController,
    ConversationsController,
    MembersController,
    WorkspaceStorageController,
  ],
  providers: [
    Database,
    AuthService,
    SessionGuard,
    DocumentsService,
    TasksService,
    TaskCommentsService,
    MembersService,
    StorageSecretBox,
    WorkspaceStorageService,
    CommandCodeTaskProposalModel,
    ConversationsService,
    { provide: APP_GUARD, useClass: RequestGuard },
  ],
})
export class AppModule {}
