import { IsNotEmpty, IsString } from 'class-validator';
import { CreateWhatsappWebDto } from './create-whatsapp-web.dto';
import { PartialType } from '@nestjs/mapped-types';


export class UpdateWhatsappWebDto extends PartialType(CreateWhatsappWebDto) {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  groupId: string;
}

