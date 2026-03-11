import { IsNotEmpty, IsString } from 'class-validator';

export class CreateWhatsappWebDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  groupId: string;
}

