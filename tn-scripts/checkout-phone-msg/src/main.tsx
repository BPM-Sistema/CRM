import { Box, Text } from "@tiendanube/nube-sdk-jsx";
import { styled } from "@tiendanube/nube-sdk-ui";
import type { NubeSDK } from "@tiendanube/nube-sdk-types";

const Container = styled(Box)`
  margin: 8px 0 14px;
  padding: 12px 14px;
  background: #f0fdf4;
  border-left: 4px solid #25d366;
  border-radius: 8px;
`;

const Title = styled(Text)`
  font-size: 14px;
  font-weight: 600;
  color: #075e54;
  margin: 0 0 4px;
`;

const Body = styled(Text)`
  font-size: 13px;
  line-height: 1.45;
  color: #14532d;
  margin: 0;
`;

function PhoneMessage() {
  return (
    <Container>
      <Title>📱 Cargá un número con WhatsApp activo</Title>
      <Body>
        Importante: te avisamos por ahí todas las novedades de tu pedido (pago,
        preparación y envío).
      </Body>
    </Container>
  );
}

export function App(nube: NubeSDK) {
  nube.render("before_address_form", <PhoneMessage />);
}
